import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_LOGO_SIZE = 256 * 1024
const MAX_README_TITLE_LENGTH = 60
const contentTypes = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}
const metadataFiles = [
  'package.json',
  'electron-builder.json',
  'electron-builder.yml',
  'electron-builder.yaml',
  'src-tauri/tauri.conf.json',
  'app.json',
  'README.md'
]
const logoFiles = [
  'resources/icon',
  'build/icon',
  'icon',
  'logo',
  'public/favicon',
  'public/logo',
  'assets/icon',
  'src/assets/logo',
  'app/icon'
].flatMap((base) => Object.keys(contentTypes).map((extension) => `${base}${extension}`))
const watchedFiles = [...metadataFiles, ...logoFiles]
const cache = new Map()

const cleanName = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function yamlProductName(source) {
  const line = source
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .find((line) => /^productName\s*:/.test(line))
  if (!line) {
    return null
  }
  const value = line.replace(/^productName\s*:\s*/, '').trim()
  const doubleQuoted = /^("(?:\\.|[^"\\])*")\s*(?:#.*)?$/.exec(value)
  if (doubleQuoted) {
    try {
      return cleanName(JSON.parse(doubleQuoted[1]))
    } catch {
      return null
    }
  }
  const singleQuoted = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value)
  if (singleQuoted) {
    return cleanName(singleQuoted[1].replace(/''/g, "'"))
  }
  const unquoted = value.replace(/\s+#.*$/, '').trim()
  return unquoted === 'null' || unquoted === '~' ? null : cleanName(unquoted)
}

async function readYamlProductName(path) {
  try {
    return yamlProductName(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function cleanReadmeTitle(raw) {
  const title = raw
    .replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title || [...title].length > MAX_README_TITLE_LENGTH || /[.!?。！？]$/.test(title)) {
    return null
  }
  const words = title.split(/\s+/)
  if (words.length > 8) {
    return null
  }
  if (
    words.length > 3 &&
    /\b(?:is|are|was|were|be|being|been|contains?|provides?|supports?|helps?|uses?|offers?)\b/i.test(
      title
    )
  ) {
    return null
  }
  return /^(?:这是|本项目|该项目|这个(?:项目|仓库))/.test(title) ? null : title
}

async function readmeName(path) {
  try {
    const source = await readFile(path, 'utf8')
    for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = /^ {0,3}#(?!#)[ \t]+(.*?)[ \t]*$/.exec(line)
      if (match) {
        return cleanReadmeTitle(match[1])
      }
    }
  } catch {
    return null
  }
  return null
}

async function detectName(root) {
  const packageJson = await readJson(join(root, 'package.json'))
  let name = cleanName(packageJson?.productName) || cleanName(packageJson?.build?.productName)
  for (const file of ['electron-builder.json', 'electron-builder.yml', 'electron-builder.yaml']) {
    if (name) {
      break
    }
    const path = join(root, file)
    name = file.endsWith('.json')
      ? cleanName((await readJson(path))?.productName)
      : await readYamlProductName(path)
  }
  if (!name) {
    name = cleanName((await readJson(join(root, 'src-tauri/tauri.conf.json')))?.productName)
  }
  if (!name) {
    name = cleanName((await readJson(join(root, 'app.json')))?.expo?.name)
  }
  if (!name) {
    name = await readmeName(join(root, 'README.md'))
  }
  if (!name) {
    name = cleanName(packageJson?.name)?.replace(/^@[^/]+\//, '') || null
  }
  return name || basename(root) || root
}

function isWithin(root, path) {
  const child = relative(root, path)
  return child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

async function detectLogo(root) {
  for (const file of logoFiles) {
    try {
      const path = await realpath(join(root, file))
      if (!isWithin(root, path)) {
        continue
      }
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_LOGO_SIZE) {
        continue
      }
      return {
        path,
        mtimeMs: info.mtimeMs,
        size: info.size,
        contentType: contentTypes[extname(file)]
      }
    } catch {
      // Missing and unreadable candidates simply fall through to the next fixed path.
    }
  }
  return null
}

async function fingerprint(root) {
  const entries = await Promise.all(
    watchedFiles.map(async (file) => {
      const path = join(root, file)
      try {
        const info = await stat(path)
        const canonical = await realpath(path).catch(() => '')
        const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
        return [file, kind, info.mtimeMs, info.size, canonical].join('\0')
      } catch {
        return `${file}\0missing`
      }
    })
  )
  return entries.join('\n')
}

async function canonicalRoot(dir) {
  const absolute = resolve(typeof dir === 'string' && dir ? dir : '.')
  try {
    return await realpath(absolute)
  } catch {
    return absolute
  }
}

export async function detectProjectIdentity(dir) {
  const root = await canonicalRoot(dir)
  const currentFingerprint = await fingerprint(root)
  const cached = cache.get(root)
  if (cached?.fingerprint === currentFingerprint) {
    return cached.identity
  }
  const identity = { name: await detectName(root), logo: await detectLogo(root) }
  cache.set(root, { fingerprint: currentFingerprint, identity })
  return identity
}

export async function businessIdentity(business) {
  const detected = await detectProjectIdentity(business.workspacePath)
  const nameSource = business.nameSource === 'user' ? 'user' : 'auto'
  const userName = cleanName(business.name)
  return {
    name: nameSource === 'user' && userName ? userName : detected.name,
    nameSource,
    ...(detected.logo
      ? {
          logo: `/api/businesses/${encodeURIComponent(business.id)}/logo?v=${Math.trunc(detected.logo.mtimeMs)}`
        }
      : {})
  }
}

export function clearProjectIdentityCache() {
  cache.clear()
}

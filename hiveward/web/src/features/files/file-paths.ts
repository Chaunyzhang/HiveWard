/** 文件查看器按扩展名分几种看法；白名单外的只给文件信息和下载 */
export type FileKind =
  | 'markdown'
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'other'

const KINDS: [FileKind, string[]][] = [
  ['markdown', ['md', 'markdown', 'mdx']],
  [
    'text',
    [
      'txt',
      'log',
      'json',
      'jsonl',
      'yaml',
      'yml',
      'toml',
      'ini',
      'conf',
      'env',
      'csv',
      'tsv',
      'xml',
      'svg',
      'html',
      'htm',
      'css',
      'scss',
      'less',
      'js',
      'mjs',
      'cjs',
      'jsx',
      'ts',
      'mts',
      'cts',
      'tsx',
      'vue',
      'svelte',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'swift',
      'c',
      'h',
      'cc',
      'cpp',
      'hpp',
      'cs',
      'php',
      'lua',
      'r',
      'sql',
      'sh',
      'bash',
      'zsh',
      'fish',
      'ps1',
      'bat',
      'gitignore',
      'dockerfile',
      'makefile',
      'lock',
    ],
  ],
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']],
  ['video', ['mp4', 'm4v', 'webm', 'mov']],
  ['audio', ['mp3', 'm4a', 'wav', 'ogg']],
  ['pdf', ['pdf']],
]

const BY_EXT = new Map<string, FileKind>()
for (const [kind, exts] of KINDS) {
  for (const ext of exts) {
    BY_EXT.set(ext, kind)
  }
}

export function extOf(name: string) {
  const base = basename(name).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1) : base
}

export function kindOf(name: string): FileKind {
  return BY_EXT.get(extOf(name)) ?? 'other'
}

/** 能在查看器里改了存回去的 */
export const editable = (kind: FileKind) =>
  kind === 'markdown' || kind === 'text'

export const sepOf = (path: string) =>
  path.includes('\\') && !path.includes('/') ? '\\' : '/'

export function basename(path: string) {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path
  )
}

export function dirname(path: string) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i > 0 ? path.slice(0, i) : path
}

export const isAbsolute = (path: string) =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

/**
 * 相对路径按 base 目录解析成绝对路径（处理 ./ 和 ../），绝对路径原样返回；
 * 用 base 的分隔符，Windows 路径照样对。
 */
export function resolvePath(base: string, rel: string) {
  if (isAbsolute(rel)) {
    return rel
  }
  const sep = sepOf(base)
  const parts = base.replace(/[\\/]+$/, '').split(/[\\/]/)
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg === '..') {
      if (parts.length > 1) {
        parts.pop()
      }
    } else if (seg && seg !== '.') {
      parts.push(seg)
    }
  }
  return parts.join(sep) || sep
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 文档里的链接指向的本地路径（相对或绝对）；网址、邮件、页内锚点返回 null */
export function localHref(href: string | undefined) {
  if (!href || href.startsWith('#')) {
    return null
  }
  if (/^file:\/\//i.test(href)) {
    return decode(href.slice('file://'.length))
  }
  if (/^[A-Za-z]:[\\/]/.test(href)) {
    return href
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return null
  }
  return decode(href.split('#')[0].split('?')[0]) || null
}

/**
 * 对话里的一段文字像不像文件路径：绝对路径（/Users/…、C:\…，以分隔符结尾的当文件夹），
 * 或带认识的扩展名的相对文件名（00-summary.md、docs/plan.md）。
 */
export function looksLikePath(text: string) {
  const s = text.trim()
  if (!s || s.length > 400 || /[\n<>"|*?`]/.test(s)) {
    return false
  }
  if (
    /^(\/(Users|home|Volumes|tmp|private|opt|mnt|srv)\/|[A-Za-z]:\\)/.test(s)
  ) {
    return true
  }
  return /^[\w.\-/@\u4e00-\u9fff]+$/.test(s) && kindOf(s) !== 'other'
}

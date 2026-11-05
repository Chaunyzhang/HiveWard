import { posix, win32 } from 'node:path'

export const fileError = (status, code, message) =>
  Object.assign(new Error(message), { status, code })
export function filePathPolicy({
  platform = process.platform,
  home,
  systemDrive = process.env.SystemDrive || 'C:'
}) {
  const path = platform === 'win32' ? win32 : posix
  const key = (value) => (platform === 'win32' ? value.toLowerCase() : value)
  const within = (value, root) => {
    const rel = path.relative(key(root), key(value))
    return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
  }
  const validate = (value) => {
    if (
      typeof value !== 'string' ||
      !path.isAbsolute(value) ||
      // oxlint-disable-next-line no-control-regex -- 文件名中的控制字符可注入终端和日志
      /[\0-\x1f\x7f-\x9f]/.test(value) ||
      value.split(/[/\\]/).includes('..')
    ) {
      throw fileError(400, 'invalid_path', '必须使用目标电脑的绝对路径，不能含 ..')
    }
    const normalized = path.normalize(value)
    const parts = normalized.slice(path.parse(normalized).root.length).split(/[/\\]/)
    if (
      parts.some((part) => part.startsWith('.')) ||
      (platform === 'win32' &&
        /^(?:\$recycle\.bin|system volume information|windows|program files(?: \(x86\))?|programdata|recovery)$/i.test(
          parts[0]
        ))
    ) {
      throw fileError(403, 'file_forbidden', '隐藏文件和系统目录不共享')
    }
    if (platform === 'win32') {
      if (
        !/^[a-z]:[\\/]/i.test(value) ||
        parts.some(
          (part) =>
            /[:<>"|?*]|[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
        )
      ) {
        throw fileError(403, 'file_forbidden', '不支持设备路径、UNC、备用数据流或特殊文件名')
      }
      if (
        key(path.parse(normalized).root) === key(`${systemDrive}\\`) &&
        !within(normalized, home)
      ) {
        throw fileError(403, 'file_forbidden', '系统盘只共享当前用户目录内的文件夹')
      }
      if (
        ['AppData', 'Application Data', 'Local Settings'].some((folder) =>
          within(normalized, path.join(home, folder))
        )
      ) {
        throw fileError(403, 'file_forbidden', '系统及应用数据目录不共享')
      }
    } else if (
      [
        '/etc',
        '/private/etc',
        '/proc',
        '/sys',
        '/dev',
        '/bin',
        '/sbin',
        '/usr',
        '/System',
        '/Library',
        '/private/var'
      ].some((root) => within(normalized, root))
    ) {
      throw fileError(403, 'file_forbidden', '系统目录不共享')
    }
    return normalized
  }
  return { path, within, validate }
}

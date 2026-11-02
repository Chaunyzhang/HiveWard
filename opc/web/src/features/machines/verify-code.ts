/** 6 位确认码分两段显示：123 456 */
export const spaced = (code: string) =>
  code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code

const PLATFORMS: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

export const platformName = (p: string) => PLATFORMS[p] ?? p

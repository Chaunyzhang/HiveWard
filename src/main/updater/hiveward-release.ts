import { createHash, timingSafeEqual } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { parse } from 'yaml'
import { compareAppVersions, isValidAppVersion } from '../../shared/app-version'

export const HIVEWARD_RELEASE_REPOSITORY = 'Chaunyzhang/HiveWard'
export const HIVEWARD_RELEASE_API = `https://api.github.com/repos/${HIVEWARD_RELEASE_REPOSITORY}/releases/latest`
const RELEASE_DOWNLOAD = `https://github.com/${HIVEWARD_RELEASE_REPOSITORY}/releases/download/`
const STABLE_RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const MAX_ZIP_BYTES = 4 * 1024 ** 3

export type HiveWardRelease = {
  version: string
  notes: string
  url: string
  manifestUrl: string
}
export type MacReleaseArchive = { url: string; sha512: string; size: number }
export type ReleaseFetch = (url: string, init?: RequestInit) => Promise<Response>

async function fetchUpdateResource(
  url: string,
  fetchRelease: ReleaseFetch,
  init?: RequestInit
): Promise<Response> {
  if (!url.startsWith(`${HIVEWARD_RELEASE_API}`) && !url.startsWith(RELEASE_DOWNLOAD)) {
    throw new Error('更新资源不属于 HiveWard')
  }
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetchRelease(url, { ...init, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response
    }
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) {
      throw new Error('更新服务器跳转无效')
    }
    const next = new URL(location, url)
    const repositoryPath = next.pathname.toLowerCase()
    const ownRepository =
      next.hostname === 'api.github.com'
        ? repositoryPath.startsWith('/repos/chaunyzhang/hiveward/')
        : next.hostname !== 'github.com' ||
          repositoryPath.startsWith('/chaunyzhang/hiveward/releases/')
    if (
      !ownRepository ||
      next.protocol !== 'https:' ||
      next.username ||
      next.password ||
      next.port ||
      ![
        'api.github.com',
        'github.com',
        'objects.githubusercontent.com',
        'release-assets.githubusercontent.com'
      ].includes(next.hostname)
    ) {
      throw new Error('更新服务器跳转到未授权地址')
    }
    url = next.href
  }
  throw new Error('更新服务器跳转次数过多')
}

export function isNewHiveWardVersion(current: string, candidate: string): boolean {
  return (
    isValidAppVersion(current) &&
    isValidAppVersion(candidate) &&
    STABLE_RELEASE_VERSION.test(candidate) &&
    candidate
      .split('+')[0]
      .split('.')
      .every((part) => Number.isSafeInteger(Number(part))) &&
    compareAppVersions(candidate, current) > 0
  )
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.ok || !response.body) {
    throw new Error(`更新服务器返回 ${response.status}`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > limit) {
        throw new Error('更新说明超过大小限制')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export async function findHiveWardRelease(
  current: string,
  fetchRelease: ReleaseFetch
): Promise<HiveWardRelease | null> {
  const response = await fetchUpdateResource(HIVEWARD_RELEASE_API, fetchRelease, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 404) {
    return null
  }
  const release = JSON.parse(await boundedText(response, 1024 * 1024))
  const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : ''
  if (release.draft || release.prerelease || !isNewHiveWardVersion(current, version)) {
    return null
  }
  const tag = encodeURIComponent(release.tag_name)
  const manifestUrl = `${RELEASE_DOWNLOAD}${tag}/latest-mac.yml`
  if (!Array.isArray(release.assets)) {
    throw new Error('更新缺少发布资源')
  }
  return {
    version,
    notes: typeof release.body === 'string' ? release.body : '',
    url: `https://github.com/${HIVEWARD_RELEASE_REPOSITORY}/releases/tag/${tag}`,
    manifestUrl
  }
}

export async function readMacReleaseArchive(
  release: HiveWardRelease,
  arch: string,
  fetchRelease: ReleaseFetch
): Promise<MacReleaseArchive> {
  const response = await fetchUpdateResource(release.manifestUrl, fetchRelease, {
    signal: AbortSignal.timeout(30_000)
  })
  const manifest = parse(await boundedText(response, 128 * 1024))
  if (manifest?.version !== release.version || !Array.isArray(manifest.files)) {
    throw new Error('更新清单版本不一致')
  }
  const filename = `HiveWard-${release.version}-mac-${arch}.zip`
  const file = manifest.files.find((entry: { url?: unknown }) => entry.url === filename)
  if (
    !file ||
    typeof file.sha512 !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_ZIP_BYTES
  ) {
    throw new Error('更新清单缺少有效的 ZIP 和 SHA-512')
  }
  return { url: new URL(filename, release.manifestUrl).href, sha512: file.sha512, size: file.size }
}

export async function downloadVerifiedArchive(
  archive: MacReleaseArchive,
  destination: string,
  fetchRelease: ReleaseFetch,
  progress: (percent: number) => void = () => {}
): Promise<void> {
  const partial = `${destination}.partial`
  const response = await fetchUpdateResource(archive.url, fetchRelease, {
    signal: AbortSignal.timeout(30 * 60_000)
  })
  if (!response.ok || !response.body) {
    throw new Error('下载更新失败')
  }
  const hash = createHash('sha512')
  const reader = response.body.getReader()
  const file = await open(partial, 'wx', 0o600)
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > archive.size || size > MAX_ZIP_BYTES) {
        throw new Error('更新文件大小不符')
      }
      hash.update(value)
      await file.writeFile(value)
      progress((size / archive.size) * 100)
    }
    const expected = Buffer.from(archive.sha512, 'base64')
    const actual = hash.digest()
    if (
      size !== archive.size ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new Error('更新文件 SHA-512 校验失败')
    }
    await file.close()
    await rename(partial, destination)
  } catch (error) {
    await file.close().catch(() => {})
    await rm(partial, { force: true })
    throw error
  } finally {
    await reader.cancel().catch(() => {})
  }
}

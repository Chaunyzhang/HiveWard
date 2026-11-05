import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractManifestAssetNames,
  getRequiredReleaseAssetNames,
  verifyRequiredReleaseAssets
} from './verify-release-required-assets.mjs'

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body)))
  }
}

function releaseWithAssets(tag, assetNames) {
  return {
    tag_name: tag,
    draft: true,
    prerelease: false,
    assets: assetNames.map((name, index) => ({
      id: index + 1,
      name,
      state: 'uploaded',
      size: 123
    }))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getRequiredReleaseAssetNames', () => {
  it('includes both mac updater ZIP names for the tag version', () => {
    expect(getRequiredReleaseAssetNames('v1.4.27')).toEqual(
      expect.arrayContaining([
        'HiveWard-1.4.27-mac.zip',
        'HiveWard-1.4.27-mac.zip.blockmap',
        'HiveWard-1.4.27-arm64-mac.zip',
        'HiveWard-1.4.27-arm64-mac.zip.blockmap'
      ])
    )
  })

  it('includes x64 and arm64 Linux assets', () => {
    expect(getRequiredReleaseAssetNames('v1.4.27')).toEqual(
      expect.arrayContaining([
        'latest-linux-arm64.yml',
        'hiveward-linux.AppImage',
        'hiveward-linux-arm64.AppImage',
        'hiveward-ide_1.4.27_amd64.deb',
        'hiveward-ide_1.4.27_arm64.deb',
        'hiveward-ide-1.4.27.x86_64.rpm',
        'hiveward-ide-1.4.27.aarch64.rpm'
      ])
    )
  })
})

describe('extractManifestAssetNames', () => {
  it('extracts relative and absolute manifest asset names', () => {
    expect(
      extractManifestAssetNames(
        [
          'files:',
          '  - url: HiveWard-1.4.27-arm64-mac.zip',
          '  - url: https://example.com/downloads/hiveward-windows-setup.exe',
          'path: hiveward-linux.AppImage'
        ].join('\n')
      )
    ).toEqual(['HiveWard-1.4.27-arm64-mac.zip', 'hiveward-windows-setup.exe', 'hiveward-linux.AppImage'])
  })
})

describe('verifyRequiredReleaseAssets', () => {
  function releaseFetch(release, manifestAsset, manifestText) {
    return vi.fn(async (url) => {
      const releasesUrl = 'https://api.github.com/repos/Chaunyzhang/HiveWard/releases'
      if (url === `${releasesUrl}?per_page=100`) {
        return jsonResponse([release])
      }
      if (url === `${releasesUrl}/assets/${manifestAsset.id}`) {
        return jsonResponse(manifestText)
      }
      if (release.assets.some((asset) => url === `${releasesUrl}/assets/${asset.id}`)) {
        return jsonResponse('version: 1.4.27\n')
      }
      throw new Error(`Unexpected release request: ${url}`)
    })
  }

  it('fails when a manifest-referenced asset has not been uploaded', async () => {
    const tag = 'v1.4.27'
    const release = releaseWithAssets(tag, getRequiredReleaseAssetNames(tag))
    const latestMacAsset = release.assets.find((asset) => asset.name === 'latest-mac.yml')
    vi.stubGlobal(
      'fetch',
      releaseFetch(
        release,
        latestMacAsset,
        [
          'version: 1.4.27',
          'files:',
          '  - url: mac-updater-only.zip',
          '    sha512: test',
          'path: mac-updater-only.zip'
        ].join('\n')
      )
    )

    await expect(
      verifyRequiredReleaseAssets({ repo: 'Chaunyzhang/HiveWard', tag, token: 'token' })
    ).rejects.toThrow('Missing: mac-updater-only.zip')
  })

  it('checks assets referenced by the Linux arm64 updater manifest', async () => {
    const tag = 'v1.4.27'
    const required = getRequiredReleaseAssetNames(tag)
    const release = releaseWithAssets(tag, required)
    const arm64Manifest = release.assets.find((asset) => asset.name === 'latest-linux-arm64.yml')
    vi.stubGlobal(
      'fetch',
      releaseFetch(
        release,
        arm64Manifest,
        [
          'version: 1.4.27',
          'files:',
          '  - url: hiveward-linux-arm64.AppImage.blockmap',
          'path: hiveward-linux-arm64.AppImage'
        ].join('\n')
      )
    )

    await expect(
      verifyRequiredReleaseAssets({ repo: 'Chaunyzhang/HiveWard', tag, token: 'token' })
    ).rejects.toThrow('Missing: hiveward-linux-arm64.AppImage.blockmap')
  })
})

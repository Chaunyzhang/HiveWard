import { hivewardHomePath } from '../../shared/hiveward-profile-paths'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const LEGACY_WORKSPACE_ID = 'legacy'

function getHivewarddir(): string {
  return join(hivewardHomePath())
}

function getLegacyTokenPath(): string {
  return join(getHivewarddir(), 'linear-token.enc')
}

export function getLegacyViewerPath(): string {
  return join(getHivewarddir(), 'linear-viewer.json')
}

export function getWorkspaceFilePath(): string {
  return join(getHivewarddir(), 'linear-workspaces.json')
}

export function getWorkspaceTokenDir(): string {
  return join(getHivewarddir(), 'linear-tokens')
}

export function getWorkspaceTokenPath(workspaceId: string): string {
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    return getLegacyTokenPath()
  }
  return join(getWorkspaceTokenDir(), `${Buffer.from(workspaceId).toString('base64url')}.enc`)
}

export function ensureHivewarddir(): void {
  const dir = getHivewarddir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function ensureWorkspaceTokenDir(): void {
  const dir = getWorkspaceTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

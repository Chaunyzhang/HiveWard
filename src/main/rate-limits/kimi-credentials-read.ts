import { readFile } from 'node:fs/promises'
import { join, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getHostKimiConfigHome, type KimiHomeResolution } from '../kimi/kimi-runtime-home'
import { resolveKimiCodeRuntimeAuth } from '../kimi/kimi-code-runtime-auth'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

const CREDENTIALS_READ_TIMEOUT_MS = 5_000

function kimiHomePath(kimiHome: string, ...segments: string[]): string {
  // WSL homes arrive as `\\wsl.localhost\<distro>\...`, which only win32 join keeps intact.
  return parseWslUncPath(kimiHome)
    ? pathWin32.join(kimiHome, ...segments)
    : join(kimiHome, ...segments)
}

export type KimiCredentials = {
  access_token?: string
  expires_at?: number
}

type TextReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; raw: string }

export type CredentialsReadResult =
  | Exclude<TextReadResult, { status: 'ok' }>
  | { status: 'ok'; credentials: KimiCredentials; usageUrl: string }

function parseCredentials(value: unknown): KimiCredentials | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const credentials: KimiCredentials = {}
  if ('access_token' in value && typeof value.access_token === 'string') {
    credentials.access_token = value.access_token
  }
  if ('expires_at' in value && typeof value.expires_at === 'number') {
    credentials.expires_at = value.expires_at
  }
  return credentials
}

const textReadByPath = new Map<string, SharedAuthFilesystemOperation<TextReadResult>>()

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function readErrorMessage(err: unknown): string {
  // Timeout rejection may expose message without an Error prototype.
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : 'Unable to read Kimi credentials'
}

function getTextRead(path: string): SharedAuthFilesystemOperation<TextReadResult> {
  const existing = textReadByPath.get(path)
  if (existing) {
    return existing
  }
  // Share UNC reads until native settlement; aborting a waiter does not cancel issued I/O.
  const read = createAuthFilesystemOperation(path, async (): Promise<TextReadResult> => {
    try {
      return { status: 'ok', raw: await readFile(path, 'utf-8') }
    } catch (err) {
      return isMissingPathError(err)
        ? { status: 'missing' }
        : { status: 'error', error: readErrorMessage(err) }
    }
  })
  textReadByPath.set(path, read)
  const clearRead = (): void => {
    if (textReadByPath.get(path) === read) {
      textReadByPath.delete(path)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

async function readCredentials(kimiHome: string): Promise<CredentialsReadResult> {
  // Bound both stopped-distro UNC reads so one WSL account cannot stall the poll cycle.
  const signal = AbortSignal.timeout(CREDENTIALS_READ_TIMEOUT_MS)
  try {
    const config = await getTextRead(kimiHomePath(kimiHome, 'config.toml')).wait(signal)
    const auth = resolveKimiCodeRuntimeAuth(config.status === 'ok' ? config.raw : '')
    const credentialsPath = kimiHomePath(kimiHome, 'credentials', `${auth.tokenName}.json`)
    const file = await getTextRead(credentialsPath).wait(signal)
    if (file.status !== 'ok') {
      return file
    }
    const credentials = parseCredentials(JSON.parse(file.raw))
    return credentials
      ? { status: 'ok', credentials, usageUrl: auth.usageUrl }
      : { status: 'error', error: 'Kimi credentials file is invalid' }
  } catch (err) {
    return { status: 'error', error: readErrorMessage(err) }
  }
}

// Current Kimi CLI keeps credentials in ~/.kimi; ~/.kimi-code is the legacy home, so try current first.
function kimiHomeCandidates(home: KimiHomeResolution, path: string): string[] {
  return home.runtime === 'host' ? [...new Set([getHostKimiConfigHome(), path])] : [path]
}

/** Read the first Kimi home that has a credentials file; never refreshes or writes it. */
export async function readKimiCredentials(
  home: KimiHomeResolution,
  path: string
): Promise<CredentialsReadResult> {
  let last: CredentialsReadResult = { status: 'missing' }
  for (const kimiHome of kimiHomeCandidates(home, path)) {
    last = await readCredentials(kimiHome)
    if (last.status !== 'missing') {
      return last
    }
  }
  return last
}

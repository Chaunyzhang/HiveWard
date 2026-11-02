import { FILE_MAX_BYTES } from './files.mjs'
import { fileError } from './file-path-policy.mjs'

const IMAGE_LIMIT = 64 * 1024 * 1024

export async function readClipboardJson(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw fileError(413, 'clipboard_too_large', '剪贴板请求超过接口上限')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw fileError(400, 'bad_request', '请求体不是 JSON')
  }
}

export async function drainClipboardRequest(req, limit = 4096) {
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw fileError(413, 'body_too_large', '请求体过大')
    }
  }
}

export function validClipboardPush(body, peerId) {
  if (!body || body.origin !== peerId || !validEventId(body.eventId)) {
    throw fileError(400, 'bad_request', '剪贴板事件身份无效')
  }
  if (body.kind === 'text') {
    return validText(body)
  }
  if (body.kind === 'image' && typeof body.png === 'string') {
    const png = Buffer.from(body.png, 'base64')
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    if (
      png.length > IMAGE_LIMIT ||
      png.length < 8 ||
      !png.subarray(0, 8).equals(signature) ||
      png.toString('base64') !== body.png
    ) {
      throw fileError(400, 'bad_request', '剪贴板 PNG 无效或过大')
    }
    return { eventId: body.eventId, bytes: png.length, payload: { kind: 'image', png } }
  }
  throw fileError(400, 'bad_request', '剪贴板事件类型无效')
}

function validText(body) {
  if (
    typeof body.text !== 'string' ||
    ['html', 'rtf'].some((key) => body[key] !== undefined && typeof body[key] !== 'string')
  ) {
    throw fileError(400, 'bad_request', '剪贴板文字格式无效')
  }
  const bytes = [body.text, body.html, body.rtf]
    .filter((value) => typeof value === 'string')
    .reduce((sum, value) => sum + Buffer.byteLength(value), 0)
  return {
    eventId: body.eventId,
    bytes,
    payload: {
      kind: 'text',
      text: body.text,
      ...(body.html ? { html: body.html } : {}),
      ...(body.rtf ? { rtf: body.rtf } : {})
    }
  }
}

export function validClipboardManifest(body, peerId) {
  if (
    !body ||
    body.kind !== 'files' ||
    body.origin !== peerId ||
    !validEventId(body.eventId) ||
    !Number.isSafeInteger(body.count) ||
    body.count < 1 ||
    body.count > 1000 ||
    !Number.isSafeInteger(body.totalBytes) ||
    body.totalBytes < 0 ||
    body.totalBytes > FILE_MAX_BYTES ||
    !Array.isArray(body.entries) ||
    body.entries.length < 1 ||
    body.entries.length > 1000
  ) {
    throw fileError(400, 'invalid_clipboard_manifest', '剪贴板文件清单无效')
  }
  const paths = new Set()
  const roots = new Set()
  let bytes = 0
  for (const entry of body.entries) {
    if (!validEntry(entry) || paths.has(entry.path.toLowerCase())) {
      throw fileError(400, 'invalid_clipboard_manifest', '文件项目、大小或路径无效')
    }
    paths.add(entry.path.toLowerCase())
    roots.add(entry.path.split('/')[0].toLowerCase())
    if (entry.type === 'file') {
      bytes += entry.size
    }
  }
  if (roots.size !== body.count || bytes !== body.totalBytes) {
    throw fileError(400, 'invalid_clipboard_manifest', '文件数量或总大小不符')
  }
  return body
}

function validEntry(entry) {
  if (
    !entry ||
    typeof entry.path !== 'string' ||
    entry.path.length > 4096 ||
    !['file', 'directory'].includes(entry.type) ||
    (entry.type === 'file' && (!Number.isSafeInteger(entry.size) || entry.size < 0)) ||
    (entry.type === 'directory' && entry.size !== undefined)
  ) {
    return false
  }
  const parts = entry.path.split('/')
  return (
    !entry.path.includes('\\') &&
    // oxlint-disable-next-line no-control-regex -- 控制字符可注入日志和终端，必须拒绝
    !/[\0-\x1f\x7f-\x9f]/.test(entry.path) &&
    parts.every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'))
  )
}

function validEventId(value) {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
}

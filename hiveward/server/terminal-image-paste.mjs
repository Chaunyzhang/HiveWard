// 对话框里贴的图：照引擎手机端的做法，图先经 clipboard.*ImageUpload 存成临时文件，
// 再把文件路径当作一次「粘贴」（bracketed paste）打进 Agent 终端，Claude Code / Codex 会把它认成图片附件。
// 路径转义照 src/shared/image-path-paste.ts 的 formatImageDropPasteText。
import { call } from './hiveward-client.mjs'

// 引擎一次最多收 24MB base64，一块 512KB（src/shared/rpc-contract/clipboard-params.ts）
const MAX_BASE64 = 24 * 1024 * 1024
export const MAX_IMAGE_BYTES = Math.floor((MAX_BASE64 / 4) * 3)
const CHUNK = 512 * 1024
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const MAX_IMAGES = 10

const fail = (status, code, message) => Object.assign(new Error(message), { status, code })

async function readImage(req) {
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
  if (!IMAGE_TYPES.includes(type)) {
    throw fail(415, 'unsupported_image', '只能贴 PNG、JPEG、GIF、WebP 图片')
  }
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_IMAGE_BYTES) {
      throw fail(413, 'image_too_large', '图片太大了（最大 18MB）')
    }
    chunks.push(c)
  }
  if (!size) {
    throw fail(400, 'bad_request', '图片是空的')
  }
  return Buffer.concat(chunks)
}

/** 存成引擎的临时图片文件，返回它的路径 */
export async function saveTerminalImage(req, rpc = call) {
  const base64 = (await readImage(req)).toString('base64')
  const { uploadId } = await rpc('clipboard.startImageUpload', {
    expectedBase64Length: base64.length
  })
  try {
    for (let offset = 0; offset < base64.length; offset += CHUNK) {
      await rpc('clipboard.appendImageUploadChunk', {
        uploadId,
        offset,
        contentBase64: base64.slice(offset, offset + CHUNK)
      })
    }
    return { path: await rpc('clipboard.commitImageUpload', { uploadId }) }
  } catch (error) {
    await rpc('clipboard.abortImageUpload', { uploadId }).catch(() => {})
    throw error
  }
}

const POSIX_UNSAFE = /[ "'`$;&|<>(){}[\]*?!#\\]/
const WINDOWS_UNSAFE = /[ "'`$;&|<>(){}[\]*?!#^%]/
// oxlint-disable-next-line no-control-regex -- 控制字符会被粘贴框改写，路径就不对了
const CONTROL = /[\0-\x1f\x7f]/

/** 一张图的路径打进终端时的文字：粘贴框包着；含特殊字符时照引擎的规则转义 */
export function imagePasteText(path, platform = process.platform) {
  if (typeof path !== 'string' || !path || CONTROL.test(path)) {
    throw fail(400, 'bad_request', '图片路径不对')
  }
  const windows = platform === 'win32'
  const text = !(windows ? WINDOWS_UNSAFE : POSIX_UNSAFE).test(path)
    ? path
    : windows
      ? /^[a-zA-Z0-9_./@:\\-]+$/.test(path)
        ? path
        : `"${path}"`
      : path.replace(/[^a-zA-Z0-9_./@:\-\u0080-\uffff]/g, '\\$&')
  return `\x1b[200~${text}\x1b[201~`
}

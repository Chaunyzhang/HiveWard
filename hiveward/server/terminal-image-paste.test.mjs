import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { imagePasteText, saveTerminalImage } from './terminal-image-paste.mjs'

const image = (bytes, type = 'image/png') =>
  Object.assign(Readable.from([bytes]), { headers: { 'content-type': type } })

test('贴的图分块交给引擎存成临时文件，拿回路径', async () => {
  const calls = []
  const rpc = async (method, params) => {
    calls.push([method, params])
    return method === 'clipboard.startImageUpload'
      ? { uploadId: 'u1' }
      : method === 'clipboard.commitImageUpload'
        ? '/tmp/hiveward-paste.png'
        : {}
  }
  const bytes = Buffer.alloc(600 * 1024, 7)
  assert.deepEqual(await saveTerminalImage(image(bytes), rpc), { path: '/tmp/hiveward-paste.png' })
  const base64 = bytes.toString('base64')
  assert.deepEqual(
    calls.map(([m, p]) => [m, p.offset, p.contentBase64?.length]),
    [
      ['clipboard.startImageUpload', undefined, undefined],
      ['clipboard.appendImageUploadChunk', 0, 512 * 1024],
      ['clipboard.appendImageUploadChunk', 512 * 1024, base64.length - 512 * 1024],
      ['clipboard.commitImageUpload', undefined, undefined]
    ]
  )
  assert.equal(calls[0][1].expectedBase64Length, base64.length)
})

test('存图失败时撤掉这次上传；不是图片的直接拒', async () => {
  const calls = []
  const rpc = async (method) => {
    calls.push(method)
    if (method === 'clipboard.startImageUpload') {
      return { uploadId: 'u1' }
    }
    if (method === 'clipboard.commitImageUpload') {
      throw new Error('disk full')
    }
    return {}
  }
  await assert.rejects(saveTerminalImage(image(Buffer.from('x')), rpc), /disk full/)
  assert.equal(calls.at(-1), 'clipboard.abortImageUpload')
  await assert.rejects(saveTerminalImage(image(Buffer.from('x'), 'text/plain'), rpc), {
    status: 415
  })
})

test('图片路径当作一次粘贴打进终端，特殊字符照引擎规则转义', () => {
  assert.equal(imagePasteText('/tmp/a.png', 'darwin'), '\x1b[200~/tmp/a.png\x1b[201~')
  assert.equal(
    imagePasteText('/Users/me/My Pics/a.png', 'darwin'),
    '\x1b[200~/Users/me/My\\ Pics/a.png\x1b[201~'
  )
  assert.equal(
    imagePasteText('C:\\Users\\Ye Zhang\\a.png', 'win32'),
    '\x1b[200~"C:\\Users\\Ye Zhang\\a.png"\x1b[201~'
  )
  assert.throws(() => imagePasteText('/tmp/a\n.png', 'darwin'), { status: 400 })
})

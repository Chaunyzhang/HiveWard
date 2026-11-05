// hiwd file open：Agent 要给老板看的文件，打开在 HiveWard 工作台右栏的文件查看器里（不交给系统默认程序）。
// 照引擎 file open 的意思：默认只在右栏打开、不把窗口叫到前面；--focus 才把 HiveWard 窗口叫到前面。
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const fail = (status, code, message) => Object.assign(new Error(message), { status, code })

async function readJson(req) {
  const chunks = []
  for await (const c of req) {
    chunks.push(c)
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  } catch {
    throw fail(400, 'bad_request', '请求体不是合法 JSON')
  }
}

/** showFile({ path, dir, focus }) 把文件交给工作台窗口，窗口不在时返回 false */
export function workbenchFileRoutes(showFile) {
  return [
    [
      'POST',
      /^\/api\/workbench\/open-file$/,
      async (req, _params, _url, context) => {
        // 打开在这台电脑自己的工作台窗口里：别的电脑不能往这块屏幕上弹文件
        if (context?.isLan) {
          throw fail(403, 'forbidden', '只能打开在这台电脑自己的工作台里')
        }
        const { path, focus } = await readJson(req)
        if (typeof path !== 'string' || !isAbsolute(path)) {
          throw fail(400, 'bad_request', 'path 必须是绝对路径')
        }
        const info = await stat(path).catch(() => null)
        if (!info) {
          throw fail(404, 'not_found', `没有这个文件：${path}`)
        }
        const dir = info.isDirectory()
        if (!showFile({ path, dir, focus: focus === true })) {
          throw fail(503, 'workbench_unavailable', 'HiveWard 窗口没开，先打开 HiveWard App')
        }
        return { path, dir, shown: true }
      }
    ]
  ]
}

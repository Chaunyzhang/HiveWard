// 更新动作只在当前电脑执行；GET 不检查网络，也不触发下载或退出。
export function updateRoutes(updates) {
  if (!updates) {
    return []
  }
  const local = (context) => {
    if (context.isLan) {
      throw Object.assign(new Error('请在要更新的电脑上操作'), { status: 403 })
    }
  }
  const route = (method, path, action) => [
    method,
    new RegExp(`^/api/updates${path}$`),
    async (req, _params, _url, context) => {
      local(context)
      await action(req)
      return updates.snapshot()
    }
  ]
  return [
    route('GET', '', () => {}),
    route('POST', '/check', () => updates.check()),
    route('POST', '/download', () => {
      void updates.download()
    }),
    route('POST', '/install', async (req) => {
      const confirmation = await readUpdateBody(req)
      if (
        typeof confirmation.version !== 'string' ||
        !Number.isSafeInteger(confirmation.workingAgents) ||
        confirmation.workingAgents < 0
      ) {
        throw Object.assign(new Error('需要确认更新版本和正在工作的 Agent 数量'), { status: 400 })
      }
      await updates.install(confirmation)
    }),
    route('POST', '/automatic', async (req) => {
      const body = await readUpdateBody(req)
      if (typeof body.enabled !== 'boolean') {
        throw Object.assign(new Error('需要开关值'), { status: 400 })
      }
      updates.setAutomatic(body.enabled)
    })
  ]
}

async function readUpdateBody(req) {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (text.length > 1024) {
      throw Object.assign(new Error('请求太大'), { status: 413 })
    }
  }
  return JSON.parse(text)
}

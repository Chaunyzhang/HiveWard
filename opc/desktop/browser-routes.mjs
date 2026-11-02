// 内嵌浏览器的 HTTP 接口：给 opc 命令（也就是派出去的 Agent）和网页用。
// 操作网页（读结构、点击、填表、上传…）的接口由 automation.mjs 提供，挂在 /api/browser/tabs/:id/<动作>。
import { automationRoutes } from './automation.mjs'

const badRequest = (message) => Object.assign(new Error(message), { status: 400, code: 'bad_request' })

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw badRequest('请求体不是合法 JSON')
  }
}

export function browserRoutes(getTabs) {
  const tabs = () => getTabs()
  return [
    ['GET', /^\/api\/browser\/tabs$/, async () => ({ tabs: tabs().list() })],
    ['POST', /^\/api\/browser\/tabs$/, async (req) => {
      const body = await readJson(req)
      if (body.url !== undefined && typeof body.url !== 'string') throw badRequest('url 必须是字符串')
      if (body.profile !== undefined && !/^[\w-]{1,64}$/.test(body.profile)) throw badRequest('profile 只能是字母数字和 - _')
      return tabs().open({ url: body.url, profile: body.profile, by: body.by, activate: body.activate !== false })
    }],
    ['POST', /^\/api\/browser\/tabs\/([^/]+)\/close$/, async (_req, [id]) => tabs().close(id)],
    ['POST', /^\/api\/browser\/tabs\/([^/]+)\/activate$/, async (_req, [id]) => tabs().activate(id)],
    ['POST', /^\/api\/browser\/tabs\/([^/]+)\/goto$/, async (req, [id]) => {
      const { url } = await readJson(req)
      if (typeof url !== 'string' || !url) throw badRequest('缺少 url')
      return tabs().navigate(id, url)
    }],
    ['POST', /^\/api\/browser\/tabs\/([^/]+)\/(back|forward|reload)$/, async (_req, [id, action]) => tabs().history(id, action)],
    ['GET', /^\/api\/browser\/tabs\/([^/]+)\/screenshot$/, async (_req, [id]) => ({
      raw: await tabs().screenshot(id),
      type: 'image/png',
    })],
    ...automationRoutes(tabs, readJson),
  ]
}

// 老板确认码：老板在待办里答复受阻的派单时发一个，Agent 执行高风险的浏览器操作（发布、提交、付款…）必须带上。
// 一次性、30 分钟有效、绑定那个 Agent 的终端，Agent 自己造不出来。只存在内存里，App 重启即作废。
import { randomBytes } from 'node:crypto'

const codes = new Map()
const TTL = 30 * 60_000

export function issueConfirmation(handle) {
  const code = randomBytes(3).toString('hex').toUpperCase()
  codes.set(code, { handle, expires: Date.now() + TTL })
  return code
}

export function consumeConfirmation(handle, code) {
  const key = String(code ?? '')
    .trim()
    .toUpperCase()
  const c = codes.get(key)
  if (!c || c.expires < Date.now() || c.handle !== handle) return false
  codes.delete(key)
  return true
}

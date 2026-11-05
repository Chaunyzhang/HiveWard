import { rpc } from './api-runtime.mjs'

const BROWSER_GATE_PREFIX = 'HiveWard 浏览器操作确认：'
export const BROWSER_GATE_OPTIONS = ['同意执行', '拒绝']

export function hivewardBrowserGateQuestion(terminal, action, reason, url, body) {
  const { confirm: _confirm, ...request } = body
  return `${BROWSER_GATE_PREFIX}${JSON.stringify({ terminal, action, reason, url, request })}`
}

/** Agent 照规矩把这串原样发来申请浏览器操作 */
export const isBrowserGateQuestion = (text) =>
  typeof text === 'string' && text.startsWith(BROWSER_GATE_PREFIX)

export async function consumeHivewardBrowserGate(terminal, gateId, question, call = rpc) {
  if (typeof gateId !== 'string' || !gateId) {
    return false
  }
  const result = await call('orchestration.hivewardBrowserGateConsume', {
    terminal,
    gateId,
    question
  })
  return result.consumed
}
